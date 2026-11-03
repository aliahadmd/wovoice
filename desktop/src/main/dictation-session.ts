/** Correlates renderer audio and async results with one account-bound recording. */
export class DictationSession {
  private generation = 0
  private owner = ''
  private claimed = false
  begin(owner: string): number {
    this.owner = owner
    this.claimed = false
    return ++this.generation
  }
  active(id: number, owner: string): boolean {
    return id === this.generation && owner === this.owner
  }
  claim(id: number, owner: string): boolean {
    if (!this.active(id, owner) || this.claimed) return false
    this.claimed = true
    return true
  }
  invalidate(): void {
    this.generation++
    this.claimed = false
  }
}
