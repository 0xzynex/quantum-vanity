// Grover search on an exact (real-amplitude) statevector.
// Works in Node and in the browser.

export class Grover {
  constructor(qubits, marked = [0]) {
    this.n = qubits;
    this.N = 1 << qubits;
    this.marked = new Set(marked);
    this.amps = new Float64Array(this.N);
    this.reset();
  }

  reset() {
    this.amps.fill(1 / Math.sqrt(this.N));
    this.k = 0;
    return this;
  }

  // Phase oracle: flip the sign of every marked state.
  oracle() {
    for (const m of this.marked) this.amps[m] = -this.amps[m];
    return this;
  }

  // Diffusion: reflect every amplitude about the mean.
  diffuse() {
    let mean = 0;
    for (let i = 0; i < this.N; i++) mean += this.amps[i];
    mean /= this.N;
    for (let i = 0; i < this.N; i++) this.amps[i] = 2 * mean - this.amps[i];
    return this;
  }

  step() {
    this.oracle().diffuse();
    this.k++;
    return this;
  }

  pMarked() {
    let s = 0;
    for (const m of this.marked) s += this.amps[m] ** 2;
    return s;
  }

  norm() {
    let s = 0;
    for (let i = 0; i < this.N; i++) s += this.amps[i] ** 2;
    return s;
  }

  get optimal() {
    return Grover.optimal(this.N, this.marked.size);
  }

  static optimal(N, M = 1) {
    return Math.floor((Math.PI / 4) * Math.sqrt(N / M));
  }

  static theory(k, N, M = 1) {
    const theta = Math.asin(Math.sqrt(M / N));
    return Math.sin((2 * k + 1) * theta) ** 2;
  }
}
