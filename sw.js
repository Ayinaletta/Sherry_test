self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: '哥哥', body: '有新消息' };
  e.waitUntil(
    self.registration.showNotification(data.title || '哥哥', {
      body: data.body || '',
      icon: '/static/icon.png',
      badge: '/static/icon.png',
      tag: 'claude-msg',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/chat.html'));
});
