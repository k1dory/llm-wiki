FROM nginx:1.27-alpine
# Шаблон разворачивается при старте: подставляются только переменные WIKI_*,
# иначе envsubst съел бы $host и $proxy_add_x_forwarded_for.
ENV NGINX_ENVSUBST_FILTER=^WIKI_
COPY templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY index.html style.css app.js /usr/share/nginx/html/
EXPOSE 80
