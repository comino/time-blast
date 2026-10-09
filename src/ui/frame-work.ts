let frameTime = -1, frameDeadline = 0;

/** All charts share one four-millisecond budget per animation frame. */
function deadlineFor(timestamp: number): number {
  if (timestamp !== frameTime) { frameTime = timestamp; frameDeadline = performance.now() + 4; }
  return frameDeadline;
}

/** Leave the next rendering opportunity free, then run bounded, cancelable slices. */
export class FrameWork {
  private frame = 0;
  private epoch = 0;
  constructor(private readonly work: (deadline: number) => boolean) {}
  schedule(): void {
    if (this.frame) return;
    const epoch = this.epoch;
    this.frame = requestAnimationFrame(() => {
      if (epoch !== this.epoch) return;
      this.frame = requestAnimationFrame(timestamp => this.run(epoch, timestamp));
    });
  }
  private run(epoch: number, timestamp: number): void {
    if (epoch !== this.epoch) return;
    this.frame = 0;
    const deadline = deadlineFor(timestamp);
    if ((performance.now() >= deadline || this.work(deadline)) && epoch === this.epoch) {
      this.frame = requestAnimationFrame(time => this.run(epoch, time));
    }
  }
  cancel(): void { this.epoch++; if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; }
}
