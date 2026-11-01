'use strict';
const LIMITS = Object.freeze({ wrapper: 1, child: 1, owner: 2, app: 20, preflight: 6 });
/** @param {{wrapper:number,child:number,app:number,preflight:number}} budget */
function validate(budget) {
  for (const key of /** @type {const} */ (['wrapper', 'child', 'app', 'preflight'])) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 0 || budget[key] > LIMITS[key]) throw new Error('budget_invalid');
  }
  if (budget.wrapper + budget.child > LIMITS.owner) throw new Error('budget_invalid');
  return true;
}
module.exports = Object.freeze({ LIMITS, validate });
