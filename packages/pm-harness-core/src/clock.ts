/**
 * recvTs source: monotonic (hrtime) but anchored to wall time at process start, so timestamps from
 * different sources in one process are strictly comparable and files from successive runs still merge.
 */
export interface ClockAnchor {
  wall0: bigint;
  hr0: bigint;
}

export function makeClockAnchor(): ClockAnchor {
  return { wall0: BigInt(Date.now()) * 1_000_000n, hr0: process.hrtime.bigint() };
}

/** Pass the same anchor to several threads (hrtime is process-wide) and their timestamps compare exactly. */
export function makeRecvClock(anchor: ClockAnchor = makeClockAnchor()): () => bigint {
  const { wall0, hr0 } = anchor;
  return () => wall0 + (process.hrtime.bigint() - hr0);
}
