# Atlas 演示项目（tour）

这是一个**故意做小、但每种能力都能被看见**的项目。它不是真实业务代码，是为了让第一次打开 Atlas 的人
在几分钟内看懂"Atlas 到底能帮上什么忙"。

## 里面有什么（以及为什么）

| 文件 | 用来演示 |
|---|---|
| `src/coupon.js` | 一条真实的调用链：`redeem → validate → ledger.write`；`for...of` 循环（循环变量与元素都是未知值） |
| `src/ledger.js` | 有副作用的函数（写堆 / 可能抛异常）；一个纯函数（可独立运行） |
| `src/dispatch.js` | **解析不出来的调用**：`handlers[type](...)` 是元素访问调用，Atlas 会说"未解析"而不是猜 |
| `src/entry.js` | 入口：把上面几件事串起来，形成一条可追踪的链 |

## 打开方式

```bash
cargo build
./target/debug/atlas demo
```

它会索引这个目录、起一个本地服务，并把**带着会话令牌的地址**直接打印出来——复制那一行到浏览器即可。
