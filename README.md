# abemadl

## Required Dependencies
- node
- npm
- streamlink

## Installation
```bash
    cd /path/to/project_root/
    npm install
```
systemd unit is also available.
to use timer unit without editing:
```bash
    mkdir /media/recorded/abema/ -p  # mkdir for recorded files
    ln -s /path/to/project_root/systemd/* ~/.config/systemd/user/
    systemctl --user daemon-reload
```

then, to enable timer service,
```bash
    systemctl --user enable abemadl.timer
```
or to crawl as single-time execution,
```bash
    systemctl --user start abemadl.service 
```

## Example for execution with options
```bash
    cd /path/to/project_root/
    npm start -- crawl --dst /path/to/recorded/
```
