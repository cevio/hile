import type { Redis } from 'ioredis';
import type { DefineCacheResult, ExtractParams } from './define';
import { FORGET_CACHE_TAGS, REMOVE_CACHE_TAG, REPLACE_CACHE_TAGS } from './tag-scripts';

export class CacheTagIndex {
  constructor(
    private readonly prefix: string,
    private readonly redis: Redis,
  ) { }

  async remember<T extends string, R>(
    target: DefineCacheResult<T, R>,
    params: ExtractParams<T>,
    data: R | undefined,
    key: string,
  ): Promise<void> {
    const tags = this.resolveTags(target, params, data);
    await this.rememberTags(key, tags);
  }

  async forget<T extends string, R>(
    target: DefineCacheResult<T, R>,
    params: ExtractParams<T>,
    key: string,
  ): Promise<void> {
    const forgotten = await this.forgetKeyTags(key);
    if (forgotten > 0) return;

    const legacyTags = this.resolveTags(target, params, undefined);
    if (legacyTags.length === 0) return;
    await Promise.all(legacyTags.map(tag => this.redis.srem(this.makeTagKey(tag), key)));
  }

  async removeTag(tag: string): Promise<number> {
    const removed = await this.redis.eval(
      REMOVE_CACHE_TAG,
      1,
      this.makeTagKey(tag),
      this.makeTagPrefix(),
      this.makeKeyTagsPrefix(),
    );
    return Number(removed);
  }

  async readKeyTags(key: string): Promise<string[]> {
    return this.redis.smembers(this.makeKeyTagsKey(key));
  }

  async rememberTags(key: string, tags: string[]): Promise<void> {
    await this.replaceKeyTags(key, tags);
  }

  resolveTags<T extends string, R>(
    target: DefineCacheResult<T, R>,
    params: ExtractParams<T>,
    data: R | undefined,
  ): string[] {
    const tags = target.options.tags;
    if (!tags) return [];
    const resolved = typeof tags === 'function' ? tags(params, data) : tags;
    return [...new Set(resolved)];
  }

  private makeTagKey(tag: string): string {
    return `${this.makeTagPrefix()}${tag}`;
  }

  private makeTagPrefix(): string {
    return `${this.prefix}tag:`;
  }

  private makeKeyTagsKey(key: string): string {
    return `${this.makeKeyTagsPrefix()}${key}`;
  }

  private makeKeyTagsPrefix(): string {
    return `${this.prefix}tag-index:`;
  }

  private async replaceKeyTags(key: string, nextTags: string[]): Promise<void> {
    await this.redis.eval(
      REPLACE_CACHE_TAGS,
      1,
      this.makeKeyTagsKey(key),
      key,
      this.makeTagPrefix(),
      ...nextTags,
    );
  }

  private async forgetKeyTags(key: string): Promise<number> {
    const removed = await this.redis.eval(
      FORGET_CACHE_TAGS,
      1,
      this.makeKeyTagsKey(key),
      key,
      this.makeTagPrefix(),
    );
    return Number(removed);
  }

}
