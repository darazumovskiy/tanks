// Единственные платформенные глобалы, доступные общему пакету: кодирование строк в UTF-8 и обратно.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
