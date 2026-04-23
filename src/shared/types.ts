export type PacketStatus = "queued" | "sending" | "sent" | "retrying" | "failed";

export interface ChannelMetrics {
  utilization: number | null;
  quality?: "good" | "fair" | "poor" | "unknown";
  note?: string;
}

export interface MeshPacket {
  uuid: string;
  seq: number;
  createdAt: string;
  retries: number;
  status: PacketStatus;
  channelMetrics: ChannelMetrics;
  text: string;
}

export interface WirePayload {
  u: string;
  s: number;
  t: string;
}

export type Destination = number | "self" | "broadcast";

export interface ProducerConfig {
  batchSize: number;
  throttleMs: number;
  maxRetries: number;
  address: string;
  tls: boolean;
  queueTickMs: number;
  breakerFailures: number;
  breakerResetMs: number;
  destination: Destination;
  channel: number;
  wantAck: boolean;
}
