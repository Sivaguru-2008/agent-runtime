import { randomUUID, createHash } from "node:crypto";

export type EntityId = string;

export function createId(): EntityId {
  return randomUUID();
}

export function isValidUuid(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

export function generateDeterministicUuid(input: string): string {
  if (isValidUuid(input)) {
    return input; // Already a valid UUID
  }
  const hash = createHash("sha1").update(input).digest("hex");
  const part1 = hash.substring(0, 8);
  const part2 = hash.substring(8, 12);
  const part3 = "5" + hash.substring(13, 16);
  const octet4 = hash.substring(16, 20);
  const part4 = (parseInt(octet4[0]!, 16) & 0x3 | 0x8).toString(16) + octet4.substring(1);
  const part5 = hash.substring(20, 32);
  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}
