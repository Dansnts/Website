FROM nginx:alpine

RUN mkdir -p /www
COPY ./www /www

# Copie une configuration Nginx personnalisée (optionnelle)
COPY ./nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

# Lancer nginx en mode non-démon
CMD ["nginx", "-g", "daemon off;"]


