import {HttpRequest, HttpResponse} from "uWebSockets.js";

/**
 * Get the real client IP address by checking various headers and sources
 * @param req - The HTTP request object
 * @param res - The HTTP response object
 * @returns The detected client IP address
 */
export function getClientIp(req: HttpRequest, res: HttpResponse): string {
    // Check X-Real-IP header
    const xRealIp = req.getHeader('x-real-ip');
    if (xRealIp && xRealIp !== '127.0.0.1') {
        return xRealIp;
    }

    // Check X-Forwarded-For header
    const xForwardedFor = req.getHeader('x-forwarded-for');
    if (xForwardedFor) {
        // X-Forwarded-For can contain multiple IPs, take the first one
        const ips = xForwardedFor.split(',').map(ip => ip.trim());
        const firstIp = ips[0];
        if (firstIp && firstIp !== '127.0.0.1') {
            return firstIp;
        }
    }

    // Check CF-Connecting-IP (Cloudflare)
    const cfIp = req.getHeader('cf-connecting-ip');
    if (cfIp && cfIp !== '127.0.0.1') {
        return cfIp;
    }

    // Check True-Client-IP (Akamai)
    const trueClientIp = req.getHeader('true-client-ip');
    if (trueClientIp && trueClientIp !== '127.0.0.1') {
        return trueClientIp;
    }

    // Check proxied remote address
    const proxiedIp = Buffer.from(res.getProxiedRemoteAddressAsText()).toString('utf8');
    if (proxiedIp && proxiedIp !== '127.0.0.1') {
        return proxiedIp;
    }

    // Fallback to direct remote address
    return Buffer.from(res.getRemoteAddressAsText()).toString('utf8');
}

/**
 * Get all relevant IP information including original and proxied addresses
 * @param req - The HTTP request object
 * @param res - The HTTP response object
 * @returns Object containing various IP address information
 */
export function getIpInfo(req: HttpRequest, res: HttpResponse): {
    clientIp: string,
    originalIp: string,
    forwardedIps: string[],
    proxyIp: string
} {
    const originalIp = Buffer.from(res.getRemoteAddressAsText()).toString('utf8');
    const proxyIp = Buffer.from(res.getProxiedRemoteAddressAsText()).toString('utf8');
    const forwardedIps = (req.getHeader('x-forwarded-for') || '')
        .split(',')
        .map(ip => ip.trim())
        .filter(Boolean);

    return {
        clientIp: getClientIp(req, res),
        originalIp,
        forwardedIps,
        proxyIp,
    };
}
