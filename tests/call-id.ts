import type { BrokerCallId } from '../src/native/types.ts'

/** Construct fixture ids without depending on a version-specific runtime brand export. */
export function testCallId(id: string): BrokerCallId {
  return id as BrokerCallId
}
