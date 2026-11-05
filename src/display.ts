export function githubLabel(value: string, hiddenOwners: readonly string[]): string {
  const slash = value.indexOf('/');
  return slash > 0 && hiddenOwners.some(owner => owner.toLowerCase() === value.slice(0, slash).toLowerCase())
    ? value.slice(slash + 1) : value;
}
