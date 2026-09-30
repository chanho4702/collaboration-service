import { Redis as RedisFanout, type Configuration as RedisFanoutConfiguration } from "@hocuspocus/extension-redis";
import { IncomingMessage } from "@hocuspocus/server";

const PREFIX = "wiki:collaboration:fanout:v1";

/** ticket GETDEL과 같은 Redis URL을 쓰되 별도 pub/sub·lock namespace로 수평 확장을 구성한다. */
export function redisFanoutConfiguration(
  redisUrl: string,
  instanceId: string,
): Partial<RedisFanoutConfiguration> {
  const target = new URL(redisUrl);
  const port = target.port ? Number(target.port) : 6379;
  const path = target.pathname.replace(/^\//, "");
  const db = path ? Number(path) : 0;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("REDIS_URL port가 올바르지 않습니다");
  }
  if (!Number.isSafeInteger(db) || db < 0) {
    throw new Error("REDIS_URL database가 올바르지 않습니다");
  }

  return {
    host: target.hostname,
    port,
    identifier: instanceId,
    prefix: PREFIX,
    lockTimeout: 5_000,
    disconnectDelay: 1_000,
    awaitInitialSyncTimeout: 2_000,
    options: {
      db,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      ...(target.username ? { username: decodeURIComponent(target.username) } : {}),
      ...(target.password ? { password: decodeURIComponent(target.password) } : {}),
      ...(target.protocol === "rediss:" ? { tls: { servername: target.hostname } } : {}),
    },
  };
}

type IncomingHandler = (channel: Buffer, data: Buffer) => Promise<void>;

/** extension-redis 4.6.0 내부 중 이 클래스가 기대는 표면(버전 고정, 테스트가 실제 동작을 검증). */
interface RedisFanoutInternals {
  getKey(documentName: string): string;
  handleIncomingMessage: IncomingHandler;
  /** 로드 중(afterLoadDocument 진행 중) 문서까지 포함한 extension 로컬 문서 맵. */
  documents: Map<string, unknown>;
}

/**
 * 공동 초안 리셋 세대(reset_epoch)별로 격리한 Redis fan-out.
 *
 * extension-redis는 pub/sub 채널·store lock key를 `getKey(documentName)` 하나로 만든다. 이를
 * `<prefix>:<room>@<epoch>`로 바꿔, 리셋된 옛 epoch 문서(disconnectDelay 동안 메모리에 남음)가 새 epoch를
 * 로드한 노드의 초기 동기화·update에 섞이지 못하게 한다. Hocuspocus는 노드당 같은 이름의 문서를 하나만
 * 가지므로 room별 현재 로드 epoch(`epochOf`)로 충분하다. epoch를 아직 모르면 epoch 없는 key를 쓴다.
 *
 * 채널 격리만으로는 부족하다. extension의 수신 경로(`handleIncomingMessage`)는 수신 채널을 보지 않고
 * 메시지 안 문서 이름으로 현재 문서를 찾는다. Redis 장애로 구독 해제가 실패하면 ioredis가 재연결 때 옛 epoch
 * 구독을 되살리므로, 옛 피어의 SyncStep2/update·awareness·stateless가 새 epoch 문서에 그대로 적용된다.
 * 그래서 extension의 **유일한** 수신 진입점(sub `messageBuffer` listener)을 감싸, 모든 메시지 종류(Sync·
 * SyncReply·Awareness·QueryAwareness·Stateless·BroadcastStateless 등)에 대해
 * 1) 수신 채널이 그 room의 현재 epoch 채널과 정확히 같고 2) 메시지 안 문서 이름이 채널의 room과 같을 때만
 * 넘긴다. 옛 채널에서 온 메시지는 버리고 그 채널 해제를 다시 시도한다. 해제 실패분은 재연결(ready) 때 정리한다.
 */
export class EpochIsolatedRedisFanout extends RedisFanout {
  /**
   * 해제를 시도했지만 성공을 확인하지 못한 채널 → 강제 여부. 재연결 때 다시 해제한다. 강제(리셋 문서) 채널은
   * 그 room이 다시 로드돼도 새 epoch 채널을 쓰므로 언제 해제해도 안전하다.
   */
  private readonly pendingReleases = new Map<string, boolean>();

  constructor(
    configuration: Partial<RedisFanoutConfiguration>,
    private readonly epochOf: (documentName: string) => number | undefined,
  ) {
    super(configuration);
    const internals = this as unknown as RedisFanoutInternals;
    // getKey는 extension의 private 메서드라 선언으로 override할 수 없다. 4.6.0의 pubKey·subKey·lockKey가
    // 모두 this.getKey를 거치므로 인스턴스 속성으로 바꿔 끼운다.
    internals.getKey = (documentName) => this.channelFor(documentName);

    const original = internals.handleIncomingMessage;
    this.sub.off("messageBuffer", original);
    this.sub.on("messageBuffer", (channel: Buffer, data: Buffer) => {
      if (!this.accepts(channel, data)) return undefined;
      return original(channel, data);
    });
    // ioredis는 재연결 시 끊기기 전 구독(해제 실패분 포함)을 자동 복구한 뒤 ready를 낸다.
    this.sub.on("ready", () => this.retryReleases());
  }

  /** 리셋된 문서의 fan-out 송수신을 언로드 전에 즉시 끊는다. 실패하면 재연결 때 다시 해제한다. */
  detach(documentName: string): void {
    // 리셋 문서는 아직 로드돼 있어 현재 채널이지만, 이 epoch 채널은 다시 쓰이지 않으므로 강제로 해제한다.
    this.release(this.channelFor(documentName), true);
  }

  override async afterUnloadDocument(
    data: Parameters<RedisFanout["afterUnloadDocument"]>[0],
  ): Promise<void> {
    // 설정 hook(리셋 조정기)보다 먼저 돌므로 이 시점의 epoch는 아직 언로드한 문서의 것이다.
    const channel = this.channelFor(data.documentName);
    await super.afterUnloadDocument(data);
    // extension의 해제는 실패를 로그만 남긴다. 같은 채널을 추적 대상으로 다시 해제한다.
    if (!data.instance.documents.has(data.documentName)) this.release(channel);
  }

  private channelFor(documentName: string): string {
    const base = `${this.configuration.prefix}:${documentName}`;
    const epoch = this.epochOf(documentName);
    return epoch === undefined ? base : `${base}@${epoch}`;
  }

  /** `<prefix>:<room>[@<epoch>]` 채널에서 room을 꺼낸다. 이 prefix가 아니면 null. */
  private roomOf(channel: string): string | null {
    const prefix = `${this.configuration.prefix}:`;
    if (!channel.startsWith(prefix)) return null;
    const rest = channel.slice(prefix.length);
    const at = rest.lastIndexOf("@");
    return at < 0 ? rest : rest.slice(0, at);
  }

  private accepts(channelBuffer: Buffer, data: Buffer): boolean {
    const channel = channelBuffer.toString("utf-8");
    const room = this.roomOf(channel);
    if (room === null) return false;
    if (channel !== this.channelFor(room)) {
      // 로드된 문서가 없거나 다른 epoch를 로드한 room의 채널이다. 되살아난 옛 구독이므로 정리한다.
      this.release(channel);
      return false;
    }
    // extension은 채널이 아니라 메시지 안 문서 이름으로 적용 대상을 찾는다. 둘이 같을 때만 넘긴다.
    try {
      const identifierLength = data[0];
      if (identifierLength === undefined) return false;
      const message = new IncomingMessage(data.subarray(identifierLength + 1));
      return message.readVarString() === room;
    } catch {
      return false;
    }
  }

  /** 이 노드에 로드됐거나 로드 중인 문서가 지금 쓰는 채널이면 해제하면 안 된다. */
  private isLive(channel: string): boolean {
    const room = this.roomOf(channel);
    if (room === null || channel !== this.channelFor(room)) return false;
    const internals = this as unknown as RedisFanoutInternals;
    return Boolean(this.instance?.documents.has(room) || internals.documents.has(room));
  }

  private release(channel: string, force = false): void {
    const forced = force || this.pendingReleases.get(channel) === true;
    if (!forced && this.isLive(channel)) {
      this.pendingReleases.delete(channel);
      return;
    }
    this.pendingReleases.set(channel, forced);
    void Promise.resolve()
      .then(() => this.sub.unsubscribe(channel))
      .then(
        () => {
          this.pendingReleases.delete(channel);
        },
        () => undefined,
      );
  }

  private retryReleases(): void {
    for (const channel of [...this.pendingReleases.keys()]) this.release(channel);
  }
}
