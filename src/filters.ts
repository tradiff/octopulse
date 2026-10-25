export function filters(query: URLSearchParams, history = false) {
  const explicit = query.has('pr-state') || query.has('repo') || (history && query.has('actor-type'));
  const states = explicit ? query.getAll('pr-state') : ['tracked', 'open'];
  return {
    tracking: states.filter(value => ['tracked', 'inactive'].includes(value)),
    lifecycle: states.filter(value => ['open', 'merged', 'closed'].includes(value)),
    repository: query.get('repo') ?? '',
    actors: history ? query.getAll('actor-type').filter(value => ['self', 'human_other', 'bot'].includes(value)) : [],
  };
}
