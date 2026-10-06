/**
 * sampleVariance — 样本方差（n−1 分母；n≤1 时返回 0）。
 * 直接复制自 simple-statistics（https://github.com/simple-statistics/simple-statistics，ISC）。
 */
function sampleVariance(x) {
    var meanValue = 0;
    var sumValue = 0;
    var i;
    var n = x.length;
    for (i = 0; i < n; i++) {
        sumValue += x[i];
    }
    meanValue = sumValue / n;

    var sumSquaredDeviations = 0;
    for (i = 0; i < n; i++) {
        sumSquaredDeviations += (x[i] - meanValue) * (x[i] - meanValue);
    }

    return n > 1 ? sumSquaredDeviations / (n - 1) : 0;
}

export default sampleVariance;
