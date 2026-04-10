declare module 'crypto-js' {
  export function SHA256(data: string): { toString(): string };
  export function HmacSHA256(data: string, key: string): { toString(): string };
  export const enc: {
    Hex: { stringify(data: any): string };
    Utf8: { parse(data: string): any };
  };
  export const AES: {
    encrypt(data: string, key: string): any;
    decrypt(data: any, key: string): any;
  };
}
