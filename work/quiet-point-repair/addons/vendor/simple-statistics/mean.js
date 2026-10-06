/**
 * mean — 算术平均。
 * 直接复制自 simple-statistics（https://github.com/simple-statistics/simple-statistics，ISC），
 * 数学代码保持原样，仅去掉 CJS 包装。
 */
import sum from './sum.js';

function mean(x) {
    if (x.length === 0) {
        throw new Error('mean requires at least one data point');
    }
    return sum(x) / x.length;
}

export default mean;
