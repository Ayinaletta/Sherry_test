self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: '哥哥', body: '有新消息' };
  e.waitUntil(
    self.registration.showNotification(data.title || '哥哥', {
      body: data.body || '',
      icon: '/static/icon.png',
      badge: '/static/icon.png',
      data: { url: data.url || '/chat.html' },
      // one slot per destination, so a new post doesn't overwrite an unread chat message
      tag: 'home-' + (data.url || '/chat.html'),
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/chat.html';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (new URL(c.url).pathname === new URL(url, c.url).pathname && 'focus' in c) return c.focus();
    }
    return clients.openWindow(url);
  }));
});
