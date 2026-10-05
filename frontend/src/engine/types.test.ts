import { describe, expect, it } from 'vitest';
import { applyablePlans, groupByPage, pageNumbers } from '../workspace/issues';
import { WITH_PLAN, plan, inspection } from '../test/fixtures';

describe('issues helpers (presentation only)', () => {
  it('groups by page, sorted, without dropping items', () => {
    const g = groupByPage([{ pageIndex: 5, n: 1 }, { pageIndex: 1, n: 2 }, { pageIndex: 5, n: 3 }]);
    expect(g.map((x) => [x.pageIndex, x.items.length])).toEqual([[1, 1], [5, 2]]);
    expect(pageNumbers([{ pageIndex: 5 }, { pageIndex: 1 }, { pageIndex: 5 }])).toEqual([2, 6]);
  });

  it('only offers plans the engine marked applyable', () => {
    expect(applyablePlans(WITH_PLAN)).toHaveLength(1);
    const r = inspection({ verdict: 'NEEDS_ATTENTION', autofixPlans: [plan({ applyable: false, applyableReason: 'x' })] });
    expect(applyablePlans(r)).toHaveLength(0);
  });
});
