import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { signal } from '@angular/core';
import {
  injectScope,
  scopedEffect,
  injectAsync,
  injectLatest,
  injectEventStream,
  injectWorker,
} from '../src/index.js';
import { sleep, isAbort } from '@scopekit/core/signal';
import type { api as EchoApi } from '../../core/test/browser/fixtures/echo.worker.js';

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

beforeEach(() => TestBed.configureTestingModule({}));
afterEach(() => TestBed.resetTestingModule());

describe('angular adapter', () => {
  test('injectScope closes when the injector is destroyed', () => {
    const scope = TestBed.runInInjectionContext(() => injectScope());
    expect(scope.signal.aborted).toBe(false);
    TestBed.resetTestingModule();
    expect(scope.signal.aborted).toBe(true);
  });

  test('scopedEffect re-runs with a fresh scope when a signal changes', async () => {
    const id = signal(1);
    const signals: AbortSignal[] = [];
    TestBed.runInInjectionContext(() =>
      scopedEffect(scope => {
        void id();
        signals.push(scope.signal);
      }),
    );
    TestBed.tick();
    id.set(2);
    TestBed.tick();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  test('injectAsync tracks state and drops cancelled results', async () => {
    const id = signal(1);
    const state = TestBed.runInInjectionContext(() =>
      injectAsync(async scope => {
        const cur = id();
        await sleep(cur === 1 ? 50 : 5, scope.signal);
        return `user-${cur}`;
      }),
    );
    TestBed.tick();
    expect(state.loading()).toBe(true);
    id.set(2);
    TestBed.tick();
    await sleep(80);
    expect(state.data()).toBe('user-2');
    expect(state.loading()).toBe(false);
  });

  test('injectLatest cancels older calls and exposes pending', async () => {
    const api = TestBed.runInInjectionContext(() =>
      injectLatest(async (q: string, sig) => {
        await sleep(q === 'a' ? 50 : 5, sig);
        return q;
      }),
    );
    const results: string[] = [];
    api
      .run('a')
      .then(r => results.push(r))
      .catch((e: unknown) => {
        if (!isAbort(e)) throw e;
      });
    api
      .run('ab')
      .then(r => results.push(r))
      .catch((e: unknown) => {
        if (!isAbort(e)) throw e;
      });
    expect(api.pending()).toBe(true);
    await sleep(80);
    expect(results).toEqual(['ab']);
    expect(api.pending()).toBe(false);
  });

  test('injectEventStream and injectWorker end with the injector', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    const seen: string[] = [];
    const remote = TestBed.runInInjectionContext(() => {
      injectEventStream<MouseEvent>(button, 'click', e => {
        seen.push(e.type);
      });
      return injectWorker<typeof EchoApi>(
        () =>
          new Worker(new URL('../../core/test/browser/fixtures/echo.worker.ts', import.meta.url), {
            type: 'module',
          }),
      );
    });
    button.click();
    await sleep(5);
    expect(seen).toEqual(['click']);
    await expect(remote.double(8)).resolves.toBe(16);
    TestBed.resetTestingModule();
    button.click();
    await sleep(5);
    expect(seen).toEqual(['click']);
    await expect(remote.double(1)).rejects.toThrow(/disposed/);
    button.remove();
  });
});
