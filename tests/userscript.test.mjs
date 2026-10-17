import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(testDir, '..', 'B站动态分组筛选助手.js');
const source = await readFile(scriptPath, 'utf8');
const packageJson = JSON.parse(await readFile(resolve(testDir, '..', 'package.json'), 'utf8'));
const readme = await readFile(resolve(testDir, '..', 'README.md'), 'utf8');

let api;
vm.runInNewContext(source, {
    unsafeWindow: {
        __GF_TEST_HOOK__(exports) {
            api = exports;
        }
    },
    URL,
    console
}, {
    filename: scriptPath
});

test('测试钩子可以导出纯函数', () => {
    assert.ok(api);
    assert.equal(typeof api.filterDynamicItems, 'function');
    assert.equal(typeof api.buildNextPageUrl, 'function');
});

test('迁移旧版单分组存储并去重 ID', () => {
    const result = api.normalizeSelection(null, {
        ids: [199, '199', 246510],
        names: { 199: 'AIGC', 246510: '动画' },
        id: 199,
        name: 'AIGC'
    });

    assert.deepEqual(Array.from(result.ids), ['199', '246510']);
    assert.deepEqual({ ...result.names }, {
        199: 'AIGC',
        246510: '动画'
    });
});

test('旧版分组 ID 为 0 时不会被迁移逻辑丢弃', () => {
    const result = api.normalizeSelection(null, {
        ids: null,
        names: {},
        id: 0,
        name: '未分组'
    });

    assert.deepEqual(Array.from(result.ids), ['0']);
    assert.equal(result.names['0'], '未分组');
});

test('优先读取新版分组选择结构', () => {
    const result = api.normalizeSelection({
        version: 2,
        groups: [
            { id: -10, name: '默认分组' },
            { id: '246510', name: '动画' }
        ]
    }, {
        ids: [199],
        names: { 199: '旧数据' }
    });

    assert.deepEqual(Array.from(result.ids), ['-10', '246510']);
    assert.equal(result.names['-10'], '默认分组');
    assert.equal(result.names['246510'], '动画');
});

test('多分组成员按字符串合并并去重', () => {
    const result = api.mergeMemberLists([
        ['1', 2, '2'],
        [2, '3'],
        null
    ]);

    assert.deepEqual(Array.from(result), ['1', '2', '3']);
});

test('按作者 mid 过滤动态并忽略空作者', () => {
    const items = [
        { id_str: 'a', modules: { module_author: { mid: 1 } } },
        { id_str: 'b', modules: { module_author: { mid: '2' } } },
        { id_str: 'c', modules: { module_author: { mid: 9 } } },
        { id_str: 'd', modules: {} }
    ];
    const result = api.filterDynamicItems(items, new Set(['1', '3']));

    assert.deepEqual(result.map(item => item.id_str), ['a']);
    assert.equal(api.extractDynamicMid(items[1]), '2');
    assert.equal(api.extractDynamicMid(items[3]), '');
});

test('兼容分组成员接口的数组和 list 结构', () => {
    assert.deepEqual(api.parseMemberPage({
        code: 0,
        data: [{ mid: 11 }, { mid: '12' }, {}]
    }), ['11', '12']);

    assert.deepEqual(api.parseMemberPage({
        code: 0,
        data: { list: [{ mid: 21 }] }
    }), ['21']);

    assert.throws(
        () => api.parseMemberPage({ code: -101, data: null }),
        /code=-101/
    );
});

test('构造续拉 URL 时替换 offset 并移除 update_baseline', () => {
    const result = api.buildNextPageUrl(
        'https://t.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=all&offset=old&update_baseline=1&a=b',
        'next offset',
        'https://t.bilibili.com/'
    );
    const url = new URL(result);

    assert.equal(url.searchParams.get('offset'), 'next offset');
    assert.equal(url.searchParams.get('update_baseline'), null);
    assert.equal(url.searchParams.get('type'), 'all');
    assert.equal(url.searchParams.get('a'), 'b');
});

test('动态接口匹配不把其他路径误判为动态接口', () => {
    assert.equal(api.isDynamicFeedUrl(
        '/x/polymer/web-dynamic/v1/feed/all?type=all',
        'https://t.bilibili.com/'
    ), true);
    assert.equal(api.isDynamicFeedUrl(
        'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=all',
        'https://t.bilibili.com/'
    ), true);
    assert.equal(api.isDynamicFeedUrl(
        '/x/polymer/web-dynamic/v1/feed/all-extra',
        'https://t.bilibili.com/'
    ), false);
    assert.equal(api.isDynamicFeedUrl(
        'https://example.com/x/polymer/web-dynamic/v1/feed/all',
        'https://t.bilibili.com/'
    ), false);
});

test('HTTP 和 B 站业务错误分类正确', () => {
    assert.equal(api.classifyHttpStatus(412).kind, 'risk');
    assert.equal(api.classifyHttpStatus(429).retryable, false);
    assert.equal(api.classifyHttpStatus(503).retryable, true);
    assert.equal(api.classifyHttpStatus(403).kind, 'auth');
    assert.equal(api.classifyApiCode(-101).kind, 'auth');
    assert.equal(api.classifyApiCode(-352).kind, 'risk');
    assert.equal(api.classifyApiCode(-412).kind, 'risk');
    assert.equal(api.classifyApiCode(-509).kind, 'rate-limit');
    assert.equal(api.classifyApiCode(-500001).kind, 'api');
});

test('集合比较用于判断是否有未应用修改', () => {
    assert.equal(api.setsEqual(new Set(['1', '2']), new Set(['2', '1'])), true);
    assert.equal(api.setsEqual(new Set(['1']), new Set(['1', '2'])), false);
});

test('请求预算和初始化等待保持在安全范围内', () => {
    assert.ok(api.CONFIG.DYNAMIC_SCAN_MAX_PAGES <= 20);
    assert.ok(api.CONFIG.DYNAMIC_SCAN_MAX_MS <= 10000);
    assert.ok(api.CONFIG.DYNAMIC_SCAN_DELAY_MS >= 250);
    assert.ok(api.CONFIG.INITIAL_MEMBER_WAIT_MS <= 3000);
    assert.equal(api.CONFIG.API_RETRY_COUNT <= 2, true);
});

test('动态内容不再通过 innerHTML 渲染', () => {
    assert.doesNotMatch(source, /\.innerHTML\s*=/);
    assert.doesNotMatch(source, /insertAdjacentHTML/);
    assert.doesNotMatch(source, /window\.alert\(/);
});

test('重建响应时只保留 content-type，不复制原始长度和编码头', () => {
    assert.match(
        source,
        /headers:\s*\{\s*'content-type':\s*contentType\s*\}/
    );
    assert.doesNotMatch(source, /headers:\s*(?:res|response|originalResponse)\.headers/);
});

test('发布元数据包含版本、作者、许可证和更新地址', () => {
    assert.match(source, /@version\s+18\.0\.0/);
    assert.match(source, /@author\s+chenlan432/);
    assert.match(source, /@license\s+MIT/);
    assert.match(source, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\//);
    assert.doesNotMatch(source, /@author\s+You/);
});

test('脚本、package.json 和 README 版本保持一致', () => {
    assert.equal(packageJson.version, '18.0.0');
    assert.match(readme, /当前版本：`18\.0\.0`/);
    assert.match(readme, /B%E7%AB%99%E5%8A%A8%E6%80%81%E5%88%86%E7%BB%84%E7%AD%9B%E9%80%89%E5%8A%A9%E6%89%8B\.js/);
});

test('旧版错误行为不再出现', () => {
    assert.doesNotMatch(source, /currentGroupIds\.clear\(/);
    assert.doesNotMatch(source, /MAX_EMPTY_PAGES/);
    assert.doesNotMatch(source, /SCROLL_COOLDOWN/);
});
