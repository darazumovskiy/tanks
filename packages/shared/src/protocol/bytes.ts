const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ByteWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private offset = 0;

  constructor(initialSize = 256) {
    this.buffer = new ArrayBuffer(initialSize);
    this.view = new DataView(this.buffer);
  }

  private ensure(extra: number): void {
    if (this.offset + extra <= this.buffer.byteLength) {
      return;
    }
    let size = this.buffer.byteLength * 2;
    while (size < this.offset + extra) {
      size *= 2;
    }
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buffer, 0, this.offset));
    this.buffer = next;
    this.view = new DataView(next);
  }

  u8(value: number): this {
    this.ensure(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
    return this;
  }

  i8(value: number): this {
    this.ensure(1);
    this.view.setInt8(this.offset, value);
    this.offset += 1;
    return this;
  }

  u16(value: number): this {
    this.ensure(2);
    this.view.setUint16(this.offset, value);
    this.offset += 2;
    return this;
  }

  u32(value: number): this {
    this.ensure(4);
    this.view.setUint32(this.offset, value);
    this.offset += 4;
    return this;
  }

  f32(value: number): this {
    this.ensure(4);
    this.view.setFloat32(this.offset, value);
    this.offset += 4;
    return this;
  }

  f64(value: number): this {
    this.ensure(8);
    this.view.setFloat64(this.offset, value);
    this.offset += 8;
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  // Строка до 255 байт UTF-8; длиннее — обрезается по байтам, что допустимо только для имён и кодов.
  string(value: string): this {
    const bytes = textEncoder.encode(value).subarray(0, 255);
    this.u8(bytes.length);
    this.ensure(bytes.length);
    new Uint8Array(this.buffer, this.offset, bytes.length).set(bytes);
    this.offset += bytes.length;
    return this;
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.buffer, 0, this.offset);
  }
}

export class ByteReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.byteLength - this.offset;
  }

  private need(count: number): void {
    if (this.offset + count > this.data.byteLength) {
      throw new RangeError('сообщение обрывается раньше ожидаемого');
    }
  }

  u8(): number {
    this.need(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  i8(): number {
    this.need(1);
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  }

  f32(): number {
    this.need(4);
    const value = this.view.getFloat32(this.offset);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.need(8);
    const value = this.view.getFloat64(this.offset);
    this.offset += 8;
    return value;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  string(): string {
    const length = this.u8();
    this.need(length);
    const value = textDecoder.decode(this.data.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }
}
