// The two web-push calls push.ts makes; the package ships no types.
declare module "web-push" {
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export function generateRequestDetails(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: Record<string, unknown>,
  ): { method: string; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> | null; endpoint: string };
}
