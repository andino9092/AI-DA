export interface MemorySnapshot {
  facts: { id: string; text: string }[];
  nicknames: { id: string; nickname: string; means: string }[];
}
