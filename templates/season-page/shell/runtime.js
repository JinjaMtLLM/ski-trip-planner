<script>
(function () {
  var panes = document.querySelectorAll('.pane');
  var btns = Array.prototype.slice.call(document.querySelectorAll('.tb'));
  // 内嵌时把结束标记改成带反斜杠的形式（否则 script 元素会被提前截断），这里还原。
  // 两步都要做：先把「反斜杠 + 斜杠 + script」换回正常的结束标记，再把每两个反斜杠换回一个——
  // 和 embed.js 的 escClose 互为逆运算。这段代码在模板字符串里，反斜杠会被吃掉一层，
  // 而且绝不能在这里写出结束标记的字面量（会把页面上的脚本提前截断），一律用 charCode 拼。
  var BS = String.fromCharCode(92);
  var ESC = '<' + BS + '/script';
  var CLOSE = '<' + '/script';
  var BODY = '<' + '/body>';
  var DBL = BS + BS;
  function unesc(s) { return s.split(ESC).join(CLOSE).split(DBL).join(BS); }
  function show(id) {
    if (!document.getElementById('pane-' + id)) id = 'cmp';
    btns.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-t') === id); });
    Array.prototype.forEach.call(panes, function (p) { p.classList.toggle('show', p.id === 'pane-' + id); });
    var pane = document.getElementById('pane-' + id);
    // 页签第一次被点开时才建 iframe：七份报告加起来 8MB，全部预载会拖死首屏
    if (id !== 'cmp' && pane && !pane.firstChild) {
      var holder = document.querySelector('script[data-emb="' + id + '"]');
      if (holder) {
        // 被嵌页自己把高度报上来，外层不用猜；同源读 contentDocument 在 file:// 下会被挡
        var tag = '<scr' + 'ipt>(function(){function s(){try{parent.postMessage({emb:"' + id + '",'
          + 'h:Math.max(document.documentElement.scrollHeight,document.body.scrollHeight,'
          + 'document.documentElement.offsetHeight)},"*")}catch(e){}}'
          + 'addEventListener("load",s);[60,250,700,1500,2600].forEach(function(t){setTimeout(s,t)});'
          + 'addEventListener("resize",s)})();</scr' + 'ipt>';
        var f = document.createElement('iframe');
        f.className = 'rp';
        f.style.height = '2400px';
        f.setAttribute('scrolling', 'no');
        var doc = unesc(holder.textContent);
        // 只往最后一个 </body> 前插：被嵌页的原始数据里也可能出现这个字符串
        var k = doc.lastIndexOf(BODY);
        f.srcdoc = k < 0 ? doc + tag : doc.slice(0, k) + tag + doc.slice(k);
        pane.appendChild(f);
      } else {
        pane.innerHTML = '<p style="padding:24px 0;color:#6b7280;font-size:13px">这份报告还没生成，先跑一次 compare.js。</p>';
      }
    }
    window.scrollTo(0, 0);
  }
  btns.forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-t')); }); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (el) {
    el.addEventListener('click', function (ev) { ev.preventDefault(); show(el.getAttribute('data-goto')); });
  });
  addEventListener('message', function (e) {
    var d = e.data || {};
    if (!d.emb || !d.h) return;
    var p = document.getElementById('pane-' + d.emb);
    var f = p && p.querySelector('iframe');
    if (f && d.h > 200) f.style.height = (d.h + 4) + 'px';
  });
  // 支持 #ny-wl 这类锚点：可以直接把某一页签发给别人
  var start = (location.hash || '').replace('#', '');
  if (start && start !== 'cmp') show(start);
  addEventListener('hashchange', function () { show((location.hash || '').replace('#', '') || 'cmp'); });
})();
</script>
