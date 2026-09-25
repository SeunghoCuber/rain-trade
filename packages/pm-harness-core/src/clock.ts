/**
 * recvTs source: monotonic (hrtime) but anchored to wall time at process start, so timestamps from
 * different sources in one process are strictly comparable and files from successive runs still merge.
 */
export function makeRecvClock(): () => bigint {
  const wall0 = BigInt(Date.now()) * 1_000_000n;
  const hr0 = process.hrtime.bigint();
  return () => wall0 + (process.hrtime.bigint() - hr0);
}
