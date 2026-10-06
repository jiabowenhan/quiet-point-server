/**
 * sumNthPowerDeviations — Σ(x_i − mean)^n。
 * 直接复制自 simple-statistics（https://github.com/simple-statistics/simple-statistics，ISC）。
 */
function sumNthPowerDeviations(x, n) {
    var meanValue = 0;
    var sumValue = 0;
    var i;
    var length = x.length;
    for (i = 0; i < length; i++) {
        sumValue += x[i];
    }
    meanValue = sumValue / length;

    var sumSquaredDeviations = 0;
    for (i = 0; i < length; i++) {
        sumSquaredDeviations += Math.pow(x[i] - meanValue, n);
    }

    return sumSquaredDeviations;
}

export default sumNthPowerDeviations;
