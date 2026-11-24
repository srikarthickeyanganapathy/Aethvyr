(async function () {
    const list = document.getElementById('vault-files');
    const api = globalThis.VelostreamShared.api;

    async function render() {
        try {
            const response = await api.runtime.sendMessage({ action: 'VAULT_LIST' });
            if (!response?.ok) throw new Error(response?.error || 'Cached downloads are unavailable.');
            list.replaceChildren();
            for (const job of response.jobs) {
                const row = document.createElement('li');
                const size = (job.bytes / (1024 * 1024)).toFixed(1);
                const count = job.total ? ` · ${job.completed}/${job.total} segments` : '';
                row.append(document.createTextNode(`${job.name} · ${size} MB${count} `));
                if (job.status === 'running') row.append('· In progress');
                else {
                    const open = document.createElement('a');
                    open.href = '../player/player.html?mode=offline&id=' + encodeURIComponent(job.id);
                    open.textContent = job.status === 'cached' ? 'Export' : 'Resume';
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.textContent = 'Delete';
                    remove.onclick = async () => {
                        remove.disabled = true;
                        try {
                            const result = await api.runtime.sendMessage({ action: 'VAULT_DELETE', id: job.id });
                            if (!result?.ok) throw new Error(result?.error || 'Could not delete download.');
                            await render();
                        } catch (err) { row.append(' ' + err.message); remove.disabled = false; }
                    };
                    row.append(open, ' ', remove);
                }
                list.append(row);
            }
            if (!list.children.length) list.textContent = 'No cached downloads.';
        } catch (error) { list.textContent = error.message; }
    }
    await render();
    window.addEventListener('focus', render);
})();
