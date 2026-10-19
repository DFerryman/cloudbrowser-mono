import { expect, it } from 'vitest';
import { projectBudgetMicros } from '../src/budget.js';
const budget={BudgetType:'COST',TimeUnit:'MONTHLY',BudgetLimit:{Amount:'50.0',Unit:'USD'},BillingViewArn:'arn:aws:billing::123456789012:billingview/primary'};

it('recognizes the live AWS gross-cost budget that excludes credits and refunds',()=>{
  expect(projectBudgetMicros([{...budget,FilterExpression:{Not:{Dimensions:{Key:'RECORD_TYPE',Values:['Credit','Refund']}}}}])).toBe(50_000_000);
});
it('accepts a single account-wide budget and rejects ambiguous budgets',()=>{
  expect(projectBudgetMicros([{...budget,CostFilters:{}}])).toBe(50_000_000);
  expect(projectBudgetMicros([budget,budget])).toBeNull();
  expect(projectBudgetMicros([])).toBeNull();
});
it.each([
  {FilterExpression:{Dimensions:{Key:'SERVICE',Values:['Amazon EC2']}}},
  {FilterExpression:{Not:{Dimensions:{Key:'RECORD_TYPE',Values:['Usage']}}}},
  {CostFilters:{Service:['Amazon EC2']}},
  {BillingViewArn:'arn:aws:billing::123456789012:billingview/custom'},
  {BudgetLimit:{Amount:'50',Unit:'CNY'}},
])('does not reinterpret a scoped or incompatible budget as the project budget: %j',(override)=>{
  expect(projectBudgetMicros([{...budget,...override}])).toBeNull();
});
