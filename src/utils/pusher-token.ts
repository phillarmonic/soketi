import crypto from 'crypto';

/**
 * A utility class to handle Pusher-compatible token generation and signing
 */
export class PusherToken {
    private key: string;
    private secret: string;

    /**
     * Create a new token generator
     *
     * @param key - The Pusher application key
     * @param secret - The Pusher application secret
     */
    constructor(key: string, secret: string) {
        this.key = key;
        this.secret = secret;
    }

    /**
     * Sign the given string data using HMAC SHA256
     *
     * @param stringToSign - The string to be signed
     * @returns The signed string
     */
    sign(stringToSign: string): string {
        const hmac = crypto.createHmac('sha256', this.secret);
        hmac.update(stringToSign);
        return hmac.digest('hex');
    }

    /**
     * Generate a Pusher-compatible authentication signature
     *
     * @param socketId - The socket ID
     * @param customData - Any custom string data to be included in signature
     * @returns The full authentication token string
     */
    generateAuthSignature(socketId: string, customData?: string): string {
        const stringToSign = customData ?
            `${socketId}:${customData}` :
            socketId;

        return `${this.key}:${this.sign(stringToSign)}`;
    }

    /**
     * Verify a Pusher-compatible authentication signature
     *
     * @param signature - The signature to verify
     * @param socketId - The socket ID
     * @param customData - Any custom string data that was included in signature
     * @returns boolean indicating if the signature is valid
     */
    verifySignature(signature: string, socketId: string, customData?: string): boolean {
        const expectedSignature = this.generateAuthSignature(socketId, customData);
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    }
}
