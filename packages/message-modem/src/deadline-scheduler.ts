export interface DeadlineHandle {
  deadline: number;
  callback: () => void;
  index: number;
  active: boolean;
}

const MAX_TIMER_DELAY = 2_147_483_647;

function normalizeDelay(delay: number): number {
  return Number.isFinite(delay) && delay >= 1 && delay <= MAX_TIMER_DELAY
    ? delay
    : 1;
}

/** Maintains many logical deadlines with a single active Node.js timer. */
export class DeadlineScheduler {
  private readonly heap: DeadlineHandle[] = [];
  private timer?: NodeJS.Timeout;
  private armedDeadline?: number;

  public schedule(delay: number, callback: () => void): DeadlineHandle {
    const handle: DeadlineHandle = {
      deadline: Date.now() + normalizeDelay(delay),
      callback,
      index: this.heap.length,
      active: true,
    };
    this.heap.push(handle);
    this.siftUp(handle.index);
    this.arm();
    return handle;
  }

  public reschedule(handle: DeadlineHandle, delay: number): void {
    if (!handle.active) return;
    const previous = handle.deadline;
    handle.deadline = Date.now() + normalizeDelay(delay);
    if (handle.deadline < previous) this.siftUp(handle.index);
    else this.siftDown(handle.index);
    this.arm();
  }

  public cancel(handle: DeadlineHandle | undefined): void {
    if (!handle?.active) return;
    handle.active = false;
    this.removeAt(handle.index);
    this.arm();
  }

  public clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.armedDeadline = undefined;
    for (const handle of this.heap) {
      handle.active = false;
      handle.index = -1;
    }
    this.heap.length = 0;
  }

  private readonly flush = (): void => {
    this.timer = undefined;
    this.armedDeadline = undefined;
    let now = Date.now();
    while (this.heap[0]?.deadline <= now) {
      const handle = this.removeAt(0);
      handle.active = false;
      try {
        handle.callback();
      } catch (error) {
        queueMicrotask(() => { throw error; });
      }
      now = Date.now();
    }
    this.arm();
  };

  private arm(): void {
    const next = this.heap[0];
    if (!next) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.armedDeadline = undefined;
      return;
    }
    if (this.timer && this.armedDeadline === next.deadline) return;
    if (this.timer) clearTimeout(this.timer);
    this.armedDeadline = next.deadline;
    this.timer = setTimeout(this.flush, Math.max(0, next.deadline - Date.now()));
    this.timer.unref?.();
  }

  private removeAt(index: number): DeadlineHandle {
    const removed = this.heap[index]!;
    const last = this.heap.pop()!;
    removed.index = -1;
    if (index < this.heap.length) {
      this.heap[index] = last;
      last.index = index;
      const parent = index > 0 ? Math.floor((index - 1) / 2) : -1;
      if (parent >= 0 && this.heap[index]!.deadline < this.heap[parent]!.deadline) {
        this.siftUp(index);
      } else {
        this.siftDown(index);
      }
    }
    return removed;
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent]!.deadline <= this.heap[index]!.deadline) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  private siftDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.heap.length && this.heap[left]!.deadline < this.heap[smallest]!.deadline) {
        smallest = left;
      }
      if (right < this.heap.length && this.heap[right]!.deadline < this.heap[smallest]!.deadline) {
        smallest = right;
      }
      if (smallest === index) return;
      this.swap(index, smallest);
      index = smallest;
    }
  }

  private swap(left: number, right: number): void {
    const value = this.heap[left]!;
    this.heap[left] = this.heap[right]!;
    this.heap[right] = value;
    this.heap[left]!.index = left;
    this.heap[right]!.index = right;
  }
}
