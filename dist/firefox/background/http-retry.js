export function isRetryable(err) {
    if (!err || err.name === 'AbortError') return false;
    if (typeof err.status === 'number' && err.status > 0) {
        return err.status === 408 || err.status === 429 || err.status >= 500;
    }
    return true; // network errors / timeouts
}

export class HttpError extends Error {
    constructor(status, url) {
        super(`HTTP ${status} for ${url}`);
        this.name = 'HttpError';
        this.status = status;
    }
}

/** Convert delay-seconds or an HTTP date into an absolute retry deadline. */
export function retryAfterDeadline(header, now = Date.now()) {
    if (typeof header !== 'string') return 0;
    const value = header.trim();
    if (/^\d+$/.test(value)) return Math.min(Number.MAX_SAFE_INTEGER, now + Number(value) * 1000);
    // Date.parse also accepts non-HTTP inputs such as "-1" and "1.5".
    if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[, ]/i.test(value)) return 0;
    const date = Date.parse(value);
    return date > now ? date : 0;
}
