/// <reference types="node" />
import * as http from 'http';
import * as https from 'https';
/**
 * Server构造函数配置
 */
export interface ServerConfig {
    /**
     * 要绑定的服务地址。默认0.0.0.0
     */
    host?: string;
    /**
     * 要绑定的端口。默认8080
     */
    port?: number;
    /**
     * 绑定在一个预先创建好的http服务器上。如果设置了这个，那么host与port就失效了
     */
    server?: http.Server | https.Server;
    /**
     * 只接收匹配路径上的连接。默认任意地址。注意"/"只会匹配根。
     */
    path?: string;
    /**
     * 单条消息的最大大小（byte）。默认1024 x 1024 x 10。最小1024
     */
    maxPayload?: number;
}