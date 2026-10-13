module.exports = {
  apps: [{
    name: 'pocket-notes',
    cwd: __dirname,
    script: 'server.js',
    node_args: '--env-file-if-exists=.env',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    kill_timeout: 10000,
    listen_timeout: 10000,
    wait_ready: true,
    time: true,
    env: { NODE_ENV: 'production' }
  }]
};
