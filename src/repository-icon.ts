import { Avatar, Style } from '@dicebear/core';
import blobs from '@dicebear/styles/blobs.json' with { type: 'json' };

const style = new Style(blobs);
const backgroundColor = blobs.colors.background.values.filter(color => color !== '#1e293b');

export function repositoryIcon(repository: string): string {
  return new Avatar(style, { seed: repository.toLowerCase(), size: 64, borderRadius: 12, animationProbability: 0, backgroundColor }).toString();
}
