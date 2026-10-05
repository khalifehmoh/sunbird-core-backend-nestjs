import { KeyedMutex } from './keyed-mutex';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('KeyedMutex', () => {
  it('runs tasks for the same key one at a time, in arrival order', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const task = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick();
      await tick();
      log.push(`${name}:end`);
      return name;
    };

    const results = await Promise.all([
      mutex.run('tenant-1', task('a')),
      mutex.run('tenant-1', task('b')),
      mutex.run('tenant-1', task('c')),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual([
      'a:start',
      'a:end',
      'b:start',
      'b:end',
      'c:start',
      'c:end',
    ]);
  });

  it('lets different keys run side by side', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const task = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
    };

    await Promise.all([
      mutex.run('tenant-1', task('a')),
      mutex.run('tenant-2', task('b')),
    ]);

    expect(log.slice(0, 2)).toEqual(['a:start', 'b:start']);
  });

  it('keeps going after a task fails and still reports that failure', async () => {
    const mutex = new KeyedMutex();

    const failing = mutex.run('tenant-1', () =>
      Promise.reject(new Error('boom')),
    );
    const following = mutex.run('tenant-1', () => Promise.resolve('ok'));

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
  });

  it('releases the key once the queue drains', async () => {
    const mutex = new KeyedMutex();
    await mutex.run('tenant-1', () => Promise.resolve());
    expect(
      (mutex as unknown as { tails: Map<string, unknown> }).tails.size,
    ).toBe(0);
  });
});
