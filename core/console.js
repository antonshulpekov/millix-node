import config from './config/config';

let enabled = true;
console.disable = () => enabled = false;
console.enable = () => enabled = true;
const _consoleLog = console.log;
const filters = [];

console.addFilter = function (filter) {
    filters.push(filter);
};

console.log = function () {
    if (!enabled || !config.MODE_DEBUG) {
        return;
    }
    let showLog = false;
    if (filters.length > 0 && filters.indexOf(arguments[0]) >= 0) {
        showLog = true;
    }
    showLog && _consoleLog.apply(console, arguments);
};

config.DEBUG_LOG_FILTER.forEach(filter => console.addFilter(filter));

export default console;
