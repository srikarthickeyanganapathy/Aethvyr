(async function () {
    const list = document.getElementById('local-files');
    const store = globalThis.VelostreamLocal;
    try {
        for (const entry of await store.list()) {
            const row = document.createElement('li');
            const link = document.createElement('a');
            link.href = '../player/player.html?mode=local&file=' + encodeURIComponent(entry.id);
            link.textContent = entry.name + ' (' + Math.floor(entry.time) + ' s)';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'Remove';
            remove.onclick = async () => {
                try { await store.remove(entry.id); row.remove(); }
                catch (err) { remove.title = err.message; }
            };
            row.append(link, ' ', remove);
            list.append(row);
        }
        if (!list.children.length) list.textContent = 'No saved local files.';
    } catch (_) {
        list.textContent = 'Local files could not be loaded.';
    }
})();
