const QUEUE = 'fs_watch_queue';
const STATS = 'fs_watch_stats';
let writes = Promise.resolve();
function serial(fn) {
    const result = writes.then(fn);
    writes = result.catch(() => {});
    return result;
}
export function queueEdit(api, op, key) {
    return serial(async () => {
        const data = await api.storage.local.get([QUEUE, 'fs_history']);
        const history = data.fs_history || {};
        const q = data[QUEUE] || {};
        const keys = [...new Set(q.keys || [])].filter(k => Object.hasOwn(history, k));
        let previous = (Array.isArray(q.previous) ? q.previous : []).filter(k => Object.hasOwn(history, k));
        if (op === 'clear' && keys.length) previous = keys.splice(0);
        if (op === 'restore' && previous.length) {
            keys.splice(0, keys.length, ...new Set([...previous, ...keys]));
            previous = [];
        }
        const index = keys.indexOf(key);
        if (op === 'add' || op === 'first') {
            if (!Object.hasOwn(history, key)) throw Error('Video is no longer in history.');
            if (index >= 0) keys.splice(index, 1);
            if (op === 'add') keys.push(key); else keys.unshift(key);
        } else if (op === 'remove' && index >= 0) keys.splice(index, 1);
        else if (op === 'played' && index >= 0) { keys.splice(index,1); if(q.repeat) keys.push(key); }
        else if (op === 'consume' && keys[0] === key) {
            keys.shift();
            if (q.repeat) keys.push(key);
        } else if (op === 'up' && index > 0) [keys[index-1], keys[index]] = [keys[index], keys[index-1]];
        else if (op === 'down' && index >= 0 && index < keys.length-1) [keys[index+1], keys[index]] = [keys[index], keys[index+1]];
        else if (op === 'shuffle') {
            for (let i=keys.length-1; i>0; i--) {
                const j = Math.floor(Math.random()*(i+1));
                [keys[i],keys[j]] = [keys[j],keys[i]];
            }
        }
        const state = { keys, previous, repeat: op === 'repeat' ? !q.repeat : !!q.repeat, autoplay: op === 'autoplay' ? !q.autoplay : !!q.autoplay };
        await api.storage.local.set({ [QUEUE]: state });
        return state;
    });
}
export function changeStats(api, op, sample) {
    return serial(async () => {
        const s = (await api.storage.local.get(STATS))[STATS] || { enabled:false, days:{}, categories:{}, seconds:0, sessions:0, movies:0, episodes:0 };
        if (op === 'clear') { await api.storage.local.remove(STATS); return; }
        if (op === 'toggle') s.enabled = !s.enabled;
        else if (!s.enabled) return;
        else {
            const day = new Date().toISOString().slice(0,10);
            s.seconds += sample.seconds;
            s.sessions += Number(sample.first);
            s.days[day] = (s.days[day] || 0) + sample.seconds;
            for (const k of Object.keys(s.days).sort().slice(0,-31)) delete s.days[k];
            s.categories[sample.category] = (s.categories[sample.category] || 0) + sample.seconds;
            if (sample.completed === 'series') s.episodes++;
            if (sample.completed === 'movie') s.movies++;
        }
        await api.storage.local.set({ [STATS]:s });
        return s.enabled;
    });
}
