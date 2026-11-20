import assert from 'node:assert/strict';
import test from 'node:test';
import '../common/shared.js';

const { classifyLibraryMedia, sanitizePageMeta } = globalThis.VelostreamShared;

test('mixed-site movies and series follow page evidence', () => {
    assert.equal(classifyLibraryMedia({ pageUrl: 'https://flixer.example/movie/title' }).kind, 'movie');
    assert.deepEqual(classifyLibraryMedia({ pageUrl: 'https://flixer.example/watch/show/S02-E04.5' }), {
        kind: 'series', medium: '', season: 2, episode: 4.5
    });
    assert.equal(classifyLibraryMedia({ pageUrl: 'https://flixer.example/watch/123' }).kind, 'video');
});

test('Anime, Donghua and Cartoons stay distinct from format', () => {
    assert.deepEqual(classifyLibraryMedia({ pageUrl: 'https://www.animexin.example/watch/title-episode-3' }), {
        kind: 'series', medium: 'donghua', season: null, episode: 3
    });
    const animeFilm = classifyLibraryMedia({ pageUrl: 'https://aniwave.example/watch/feature', type: 'Movie', title: 'Episode Zero' });
    assert.equal(animeFilm.medium, 'anime');
    assert.equal(animeFilm.kind, 'movie');
    assert.equal(classifyLibraryMedia({ pageUrl: 'https://mixed.example/watch/1', hints: 'Chinese animation' }).medium, 'donghua');
    assert.equal(classifyLibraryMedia({ pageUrl: 'https://toontales.example/watch/1' }).medium, 'cartoon');
    assert.equal(classifyLibraryMedia({ pageUrl: 'https://notanimexin.example/watch/1' }).medium, '');
});

test('saved format survives later inference and metadata sanitization', () => {
    const meta = sanitizePageMeta({ pageUrl: 'https://mixed.example/watch/2', kind: 'movie', medium: 'anime', episode: 0 });
    assert.equal(meta.medium, 'anime');
    assert.equal(meta.episode, 0);
    assert.equal(classifyLibraryMedia({ ...meta, title: 'Episode 0' }).kind, 'movie');
});
