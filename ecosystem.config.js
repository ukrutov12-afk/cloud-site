// pm2 запуск:  pm2 start ecosystem.config.js  &&  pm2 save
module.exports = {
  apps: [{
    name: 'zephyr-client',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      HOST: '0.0.0.0'
    }
  }]
};
