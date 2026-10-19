/** Match an account-wide gross-cost budget to the same cost basis used for inventory. */
export function projectBudgetMicros(budgets: Record<string, unknown>[]): number | null {
  const candidates=budgets.filter((b)=>{
    if (b.BudgetType!=='COST' || b.TimeUnit!=='MONTHLY' || Object.keys(b.CostFilters ?? {}).length>0) return false;
    if (typeof b.BillingViewArn==='string' && !b.BillingViewArn.endsWith('/primary')) return false;
    if (b.FilterExpression && Object.keys(b.FilterExpression).length>0) {
      const expression=b.FilterExpression as {Not?:{Dimensions?:{Key?:string;Values?:string[]}}};
      const dimensions=expression.Not?.Dimensions;
      if (Object.keys(expression).length!==1 || Object.keys(expression.Not ?? {}).length!==1 || dimensions?.Key!=='RECORD_TYPE'
        || !Array.isArray(dimensions.Values) || [...dimensions.Values].sort().join(',')!=='Credit,Refund'
        || Object.keys(dimensions).some((k)=>!['Key','Values','MatchOptions'].includes(k))
        || ((dimensions as {MatchOptions?:string[]}).MatchOptions ?? []).some((o)=>o!=='EQUALS')) return false;
    }
    const limit=b.BudgetLimit as {Unit?:string;Amount?:string}|undefined;
    return limit?.Unit==='USD' && Number.isFinite(Number(limit.Amount)) && Number(limit.Amount)>=0;
  });
  return candidates.length===1 ? Math.ceil(Number((candidates[0]!.BudgetLimit as {Amount:string}).Amount)*1_000_000):null;
}
