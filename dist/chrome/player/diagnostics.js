(function () {
    'use strict';

    const finite = value => Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null;
    const pickNumbers = (source, keys) => Object.fromEntries(keys.map(key => [key, finite(source?.[key])]));

    function build({ version, userAgent, transport, modes, media, playback, network, render, history, errors }) {
        const browser = /\b(EdgA?|Firefox|FxiOS|Chrome|CriOS)\/([\d.]+)/.exec(userAgent?.match(/\bEdgA?\/[\d.]+/)?.[0] || userAgent || '');
        const codec = value => typeof value === 'string' && /^[\w.-]{1,48}$/.test(value) ? value : null;
        return {
            schema: 1,
            extensionVersion: /^\d+(\.\d+){1,3}$/.test(version) ? version : null,
            browser: browser ? { family: browser[1], version: browser[2] } : null,
            transport: ['local', 'progressive', 'hls', 'dash'].includes(transport) ? transport : null,
            modes: {
                gpu: !!modes?.gpu,
                normalization: !!modes?.normalization,
                resourceProfile: ['eco', 'balanced', 'max', 'custom'].includes(modes?.resourceProfile) ? modes.resourceProfile : null
            },
            media: {
                ...pickNumbers(media, ['width', 'height', 'totalFrames', 'droppedFrames', 'videoBitrate']),
                codecs: typeof media?.codecs === 'string' ? media.codecs.split(',').slice(0, 4).map(s => codec(s.trim())).filter(Boolean) : []
            },
            playback: pickNumbers(playback, ['startupMs', 'positionSeconds', 'bufferSeconds', 'waitingEvents', 'waitingMs']),
            network: pickNumbers(network, ['bandwidth', 'bytesDownloaded', 'lastLatencyMs', 'activeWorkers', 'cacheBytes', 'cacheCapBytes', 'cacheHits', 'cacheMisses', 'retries', 'failedAttempts']),
            render: pickNumbers(render, ['width', 'height', 'cpuSubmitMs', 'gpuMs']),
            errors: pickNumbers(errors, ['shakaCode', 'httpStatus', 'mediaCode']),
            bufferHistory: Array.isArray(history) ? history.slice(-60).map(sample => pickNumbers(sample, ['elapsedSeconds', 'bufferSeconds', 'cachedSeconds'])) : []
        };
    }

    globalThis.VelostreamDiagnostics = Object.freeze({ build });
})();
