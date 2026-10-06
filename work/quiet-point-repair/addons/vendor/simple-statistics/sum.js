/**
 * sum — 求和（数组 / 类对象）。
 * 直接复制自 simple-statistics（https://github.com/simple-statistics/simple-statistics，ISC）。
 */
function sum(x) {
    if (Array.isArray(x)) {
        return sumArray(x);
    } else if (typeof x === 'object' && x !== null) {
        return sumObject(x);
    }
    return 0;
}

function sumArray(x) {
    var sum = 0;
    for (var i = 0; i < x.length; i++) {
        sum += x[i];
    }
    return sum;
}

function sumObject(x) {
    var sum = 0;
    for (var key in x) {
        if (Object.prototype.hasOwnProperty.call(x, key)) {
            sum += x[key];
        }
    }
    return sum;
}

export default sum;
