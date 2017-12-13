"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Emitter = require("component-emitter");
/**
 * websocket 接口的抽象类，定义了需要实现的基础功能
 */
class BaseSocket extends Emitter {
    constructor(socket, configs) {
        super();
        /**
         * _messageID 的ID号，id从0开始。每发一条消息，该id加1。
         */
        this._messageID = 0;
        /**
         * 消息的发送队列。如果要取消发送，可以向send中传递以error
         */
        this._sendingQueue = new Map();
        /**
         * 该属性主要是为了方便保存一些运行期间的临时数据
         */
        this.session = {};
        this.id = BaseSocket._id_Number++;
        this._socket = socket;
        this.url = configs.url;
        this.maxPayload = configs.maxPayload == null || configs.maxPayload <= 0 ? 0 : configs.maxPayload + 4;
        this.once('close', () => {
            for (let item of [...this._sendingQueue.keys()].reverse())
                this.cancel(item, new Error('连接中断'));
        });
    }
    /**
     * 连接的当前状态
     */
    get readyState() {
        return this._socket.readyState;
    }
    /**
     * 在缓冲队列中等待发送的数据大小
     */
    get bufferedAmount() {
        let size = 0;
        for (let item of this._sendingQueue.values()) {
            size += item.size;
        }
        return size;
    }
    /**
     * 发送消息。(返回的promise中包含该条消息的messageID)
     * @param title 消息的标题
     * @param data 携带的数据
     */
    send(title, data) {
        const messageID = this._messageID++;
        const result = new Promise((resolve, reject) => {
            const b_title = Buffer.from(title);
            const b_title_length = Buffer.alloc(4);
            b_title_length.writeUInt32BE(b_title.length, 0);
            const r_data = Buffer.concat([b_title_length, b_title, data]);
            if (this.maxPayload !== 0 && r_data.length > this.maxPayload)
                throw new Error('发送的消息大小超出了限制');
            let sent = false; //是否已经执行send了
            const send = (err) => {
                if (sent)
                    return;
                else
                    sent = true;
                if (err !== undefined) {
                    reject(err);
                    this._sendingQueue.delete(messageID);
                }
                else {
                    this._sendData(r_data).then(() => {
                        this._sendingQueue.delete(messageID);
                        resolve();
                    }).catch((err) => {
                        this._sendingQueue.delete(messageID);
                        reject(err);
                    }).then(() => {
                        if (this._sendingQueue.size > 0)
                            this._sendingQueue.values().next().value.send();
                    });
                }
            };
            this._sendingQueue.set(messageID, { size: r_data.length, send });
            if (this._sendingQueue.size === 1)
                send(); //如果没有消息排队就直接发送
        });
        result.messageID = messageID;
        return result;
    }
    /**
     * 取消发送
     * @param messageID 要取消发送消息的messageID
     * @param err 传递一个error，指示取消的原因
     */
    cancel(messageID, err = new Error('发送取消')) {
        const item = this._sendingQueue.get(messageID);
        if (item != null)
            item.send(err);
    }
    /**
     * 解析接收到数据。子类接收到消息后需要触发这个方法
     *
     * @param data 接收到数据
     */
    _receiveData(data) {
        try {
            let offset = 0;
            const title_length = data.readUInt32BE(0);
            offset += 4;
            const title = data.slice(offset, offset += title_length).toString();
            const r_data = data.slice(offset);
            this.emit('message', title, r_data);
        }
        catch (error) {
            this.emit('error', error);
        }
    }
    on(event, listener) {
        super.on(event, listener);
        return this;
    }
    once(event, listener) {
        super.once(event, listener);
        return this;
    }
}
/**
 * 每新建一个接口+1
 */
BaseSocket._id_Number = 0;
exports.BaseSocket = BaseSocket;

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIkJhc2VTb2NrZXQvY2xhc3Nlcy9CYXNlU29ja2V0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsNkNBQTZDO0FBTTdDOztHQUVHO0FBQ0gsZ0JBQWlDLFNBQVEsT0FBTztJQXdENUMsWUFBWSxNQUFzQixFQUFFLE9BQXlCO1FBQ3pELEtBQUssRUFBRSxDQUFDO1FBbERaOztXQUVHO1FBQ0ssZUFBVSxHQUFHLENBQUMsQ0FBQztRQUV2Qjs7V0FFRztRQUNjLGtCQUFhLEdBQStELElBQUksR0FBRyxFQUFFLENBQUM7UUFnQnZHOztXQUVHO1FBQ0gsWUFBTyxHQUFRLEVBQUUsQ0FBQztRQXlCZCxJQUFJLENBQUMsRUFBRSxHQUFHLFVBQVUsQ0FBQyxVQUFVLEVBQUUsQ0FBQztRQUNsQyxJQUFJLENBQUMsT0FBTyxHQUFHLE1BQU0sQ0FBQztRQUN0QixJQUFJLENBQUMsR0FBRyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUM7UUFDdkIsSUFBSSxDQUFDLFVBQVUsR0FBRyxPQUFPLENBQUMsVUFBVSxJQUFJLElBQUksSUFBSSxPQUFPLENBQUMsVUFBVSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsT0FBTyxDQUFDLFVBQVUsR0FBRyxDQUFDLENBQUM7UUFFckcsSUFBSSxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUU7WUFDZixHQUFHLENBQUMsQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDLEdBQUcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDO2dCQUN0RCxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxJQUFJLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO1FBQzdDLENBQUMsQ0FBQyxDQUFDO0lBQ1AsQ0FBQztJQWhDRDs7T0FFRztJQUNILElBQUksVUFBVTtRQUNWLE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQztJQUNuQyxDQUFDO0lBRUQ7O09BRUc7SUFD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SyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFDNUIsTUFBTSxDQUFDLElBQUksQ0FBQztJQUNoQixDQUFDOztBQW5MRDs7R0FFRztBQUNZLHFCQUFVLEdBQUcsQ0FBQyxDQUFDO0FBTGxDLGdDQXNMQyIsImZpbGUiOiJCYXNlU29ja2V0L2NsYXNzZXMvQmFzZVNvY2tldC5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIEVtaXR0ZXIgZnJvbSAnY29tcG9uZW50LWVtaXR0ZXInO1xyXG5pbXBvcnQgKiBhcyBXUyBmcm9tICd3cyc7XHJcblxyXG5pbXBvcnQgeyBSZWFkeVN0YXRlIH0gZnJvbSBcIi4uL2ludGVyZmFjZXMvUmVhZHlTdGF0ZVwiO1xyXG5pbXBvcnQgeyBCYXNlU29ja2V0Q29uZmlnIH0gZnJvbSAnLi4vaW50ZXJmYWNlcy9CYXNlU29ja2V0Q29uZmlnJztcclxuXHJcbi8qKlxyXG4gKiB3ZWJzb2NrZXQg5o6l5Y+j55qE5oq96LGh57G777yM5a6a5LmJ5LqG6ZyA6KaB5a6e546w55qE5Z+656GA5Yqf6IO9XHJcbiAqL1xyXG5leHBvcnQgYWJzdHJhY3QgY2xhc3MgQmFzZVNvY2tldCBleHRlbmRzIEVtaXR0ZXIge1xyXG5cclxuICAgIC8qKlxyXG4gICAgICog5q+P5paw5bu65LiA5Liq5o6l5Y+jKzFcclxuICAgICAqL1xyXG4gICAgcHJpdmF0ZSBzdGF0aWMgX2lkX051bWJlciA9IDA7XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBfbWVzc2FnZUlEIOeahElE5Y+377yMaWTku44w5byA5aeL44CC5q+P5Y+R5LiA5p2h5raI5oGv77yM6K+laWTliqAx44CCXHJcbiAgICAgKi9cclxuICAgIHByaXZhdGUgX21lc3NhZ2VJRCA9IDA7XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDmtojmga/nmoTlj5HpgIHpmJ/liJfjgILlpoLmnpzopoHlj5bmtojlj5HpgIHvvIzlj6/ku6XlkJFzZW5k5Lit5Lyg6YCS5LulZXJyb3JcclxuICAgICAqL1xyXG4gICAgcHJpdmF0ZSByZWFkb25seSBfc2VuZGluZ1F1ZXVlOiBNYXA8bnVtYmVyLCB7IHNpemU6IG51bWJlciwgc2VuZDogKGVycj86IEVycm9yKSA9PiB2b2lkIH0+ID0gbmV3IE1hcCgpO1xyXG5cclxuICAgIC8qKlxyXG4gICAgICog5L+d5a2Y6KKr5YyF6KOF55qEc29ja2V05a+56LGhXHJcbiAgICAgKi9cclxuICAgIHByb3RlY3RlZCByZWFkb25seSBfc29ja2V0OiBXZWJTb2NrZXQgfCBXUztcclxuXHJcbiAgICAvKipcclxuICAgICAqIOW9k+WJjeaOpeWPo+eahGlkXHJcbiAgICAgKi9cclxuICAgIHJlYWRvbmx5IGlkOiBudW1iZXI7XHJcblxyXG4gICAgcmVhZG9ubHkgdXJsOiBzdHJpbmc7XHJcblxyXG4gICAgcmVhZG9ubHkgbWF4UGF5bG9hZDogbnVtYmVyO1xyXG5cclxuICAgIC8qKlxyXG4gICAgICog6K+l5bGe5oCn5Li76KaB5piv5Li65LqG5pa55L6/5L+d5a2Y5LiA5Lqb6L+Q6KGM5pyf6Ze055qE5Li05pe25pWw5o2uXHJcbiAgICAgKi9cclxuICAgIHNlc3Npb246IGFueSA9IHt9O1xyXG5cclxuICAgIC8qKlxyXG4gICAgICog6L+e5o6l55qE5b2T5YmN54q25oCBXHJcbiAgICAgKi9cclxuICAgIGdldCByZWFkeVN0YXRlKCk6IFJlYWR5U3RhdGUge1xyXG4gICAgICAgIHJldHVybiB0aGlzLl9zb2NrZXQucmVhZHlTdGF0ZTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOWcqOe8k+WGsumYn+WIl+S4reetieW+heWPkemAgeeahOaVsOaNruWkp+Wwj1xyXG4gICAgICovXHJcbiAgICBnZXQgYnVmZmVyZWRBbW91bnQoKTogbnVtYmVyIHtcclxuICAgICAgICBsZXQgc2l6ZSA9IDA7XHJcblxyXG4gICAgICAgIGZvciAobGV0IGl0ZW0gb2YgdGhpcy5fc2VuZGluZ1F1ZXVlLnZhbHVlcygpKSB7XHJcbiAgICAgICAgICAgIHNpemUgKz0gaXRlbS5zaXplO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmV0dXJuIHNpemU7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3RydWN0b3Ioc29ja2V0OiBXZWJTb2NrZXQgfCBXUywgY29uZmlnczogQmFzZVNvY2tldENvbmZpZykge1xyXG4gICAgICAgIHN1cGVyKCk7XHJcblxyXG4gICAgICAgIHRoaXMuaWQgPSBCYXNlU29ja2V0Ll9pZF9OdW1iZXIrKztcclxuICAgICAgICB0aGlzLl9zb2NrZXQgPSBzb2NrZXQ7XHJcbiAgICAgICAgdGhpcy51cmwgPSBjb25maWdzLnVybDtcclxuICAgICAgICB0aGlzLm1heFBheWxvYWQgPSBjb25maWdzLm1heFBheWxvYWQgPT0gbnVsbCB8fCBjb25maWdzLm1heFBheWxvYWQgPD0gMCA/IDAgOiBjb25maWdzLm1heFBheWxvYWQgKyA0O1xyXG5cclxuICAgICAgICB0aGlzLm9uY2UoJ2Nsb3NlJywgKCkgPT4geyAgICAvL+WmguaenOaWreW8gO+8jOe7iOatouaJgOaciei/mOacquWPkemAgeeahOa2iOaBr+OAguS7juWQjuWQkeWJjeWPlua2iFxyXG4gICAgICAgICAgICBmb3IgKGxldCBpdGVtIG9mIFsuLi50aGlzLl9zZW5kaW5nUXVldWUua2V5cygpXS5yZXZlcnNlKCkpXHJcbiAgICAgICAgICAgICAgICB0aGlzLmNhbmNlbChpdGVtLCBuZXcgRXJyb3IoJ+i/nuaOpeS4reaWrScpKTtcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOmcgOimgeWtkOexu+imhuWGmeOAgueUqOS6juWPkemAgeaVsOaNrlxyXG4gICAgICovXHJcbiAgICBwcm90ZWN0ZWQgYWJzdHJhY3QgYXN5bmMgX3NlbmREYXRhKGRhdGE6IEJ1ZmZlcik6IFByb21pc2U8dm9pZD47XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDlhbPpl63mjqXlj6PjgILlhbPpl63kuYvlkI7kvJrop6blj5FjbG9zZeS6i+S7tlxyXG4gICAgICovXHJcbiAgICBhYnN0cmFjdCBjbG9zZSgpOiB2b2lkO1xyXG5cclxuICAgIC8qKlxyXG4gICAgICog5Y+R6YCB5raI5oGv44CCKOi/lOWbnueahHByb21pc2XkuK3ljIXlkKvor6XmnaHmtojmga/nmoRtZXNzYWdlSUQpXHJcbiAgICAgKiBAcGFyYW0gdGl0bGUg5raI5oGv55qE5qCH6aKYXHJcbiAgICAgKiBAcGFyYW0gZGF0YSDmkLrluKbnmoTmlbDmja5cclxuICAgICAqL1xyXG4gICAgc2VuZCh0aXRsZTogc3RyaW5nLCBkYXRhOiBCdWZmZXIpOiBQcm9taXNlPHZvaWQ+ICYgeyBtZXNzYWdlSUQ6IG51bWJlciB9IHtcclxuICAgICAgICBjb25zdCBtZXNzYWdlSUQgPSB0aGlzLl9tZXNzYWdlSUQrKztcclxuXHJcbiAgICAgICAgY29uc3QgcmVzdWx0OiBhbnkgPSBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IGJfdGl0bGUgPSBCdWZmZXIuZnJvbSh0aXRsZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGJfdGl0bGVfbGVuZ3RoID0gQnVmZmVyLmFsbG9jKDQpO1xyXG4gICAgICAgICAgICBiX3RpdGxlX2xlbmd0aC53cml0ZVVJbnQzMkJFKGJfdGl0bGUubGVuZ3RoLCAwKTtcclxuXHJcbiAgICAgICAgICAgIGNvbnN0IHJfZGF0YSA9IEJ1ZmZlci5jb25jYXQoW2JfdGl0bGVfbGVuZ3RoLCBiX3RpdGxlLCBkYXRhXSk7XHJcblxyXG4gICAgICAgICAgICBpZiAodGhpcy5tYXhQYXlsb2FkICE9PSAwICYmIHJfZGF0YS5sZW5ndGggPiB0aGlzLm1heFBheWxvYWQpXHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+WPkemAgeeahOa2iOaBr+Wkp+Wwj+i2heWHuuS6humZkOWIticpO1xyXG5cclxuICAgICAgICAgICAgbGV0IHNlbnQgPSBmYWxzZTsgICAvL+aYr+WQpuW3sue7j+aJp+ihjHNlbmTkuoZcclxuXHJcbiAgICAgICAgICAgIGNvbnN0IHNlbmQgPSAoZXJyPzogRXJyb3IpID0+IHtcclxuICAgICAgICAgICAgICAgIGlmIChzZW50KSByZXR1cm47IGVsc2Ugc2VudCA9IHRydWU7XHJcblxyXG4gICAgICAgICAgICAgICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVqZWN0KGVycik7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc2VuZGluZ1F1ZXVlLmRlbGV0ZShtZXNzYWdlSUQpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zZW5kRGF0YShyX2RhdGEpLnRoZW4oKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9zZW5kaW5nUXVldWUuZGVsZXRlKG1lc3NhZ2VJRCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc29sdmUoKTtcclxuICAgICAgICAgICAgICAgICAgICB9KS5jYXRjaCgoZXJyKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3NlbmRpbmdRdWV1ZS5kZWxldGUobWVzc2FnZUlEKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmVqZWN0KGVycik7XHJcbiAgICAgICAgICAgICAgICAgICAgfSkudGhlbigoKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zZW5kaW5nUXVldWUuc2l6ZSA+IDApXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9zZW5kaW5nUXVldWUudmFsdWVzKCkubmV4dCgpLnZhbHVlLnNlbmQoKTtcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgdGhpcy5fc2VuZGluZ1F1ZXVlLnNldChtZXNzYWdlSUQsIHsgc2l6ZTogcl9kYXRhLmxlbmd0aCwgc2VuZCB9KTtcclxuICAgICAgICAgICAgaWYgKHRoaXMuX3NlbmRpbmdRdWV1ZS5zaXplID09PSAxKSBzZW5kKCk7ICAvL+WmguaenOayoeaciea2iOaBr+aOkumYn+WwseebtOaOpeWPkemAgVxyXG4gICAgICAgIH0pO1xyXG5cclxuICAgICAgICByZXN1bHQubWVzc2FnZUlEID0gbWVzc2FnZUlEO1xyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDlj5bmtojlj5HpgIFcclxuICAgICAqIEBwYXJhbSBtZXNzYWdlSUQg6KaB5Y+W5raI5Y+R6YCB5raI5oGv55qEbWVzc2FnZUlEXHJcbiAgICAgKiBAcGFyYW0gZXJyIOS8oOmAkuS4gOS4qmVycm9y77yM5oyH56S65Y+W5raI55qE5Y6f5ZugXHJcbiAgICAgKi9cclxuICAgIGNhbmNlbChtZXNzYWdlSUQ6IG51bWJlciwgZXJyOiBFcnJvciA9IG5ldyBFcnJvcign5Y+R6YCB5Y+W5raIJykpIHtcclxuICAgICAgICBjb25zdCBpdGVtID0gdGhpcy5fc2VuZGluZ1F1ZXVlLmdldChtZXNzYWdlSUQpO1xyXG4gICAgICAgIGlmIChpdGVtICE9IG51bGwpIGl0ZW0uc2VuZChlcnIpO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog6Kej5p6Q5o6l5pS25Yiw5pWw5o2u44CC5a2Q57G75o6l5pS25Yiw5raI5oGv5ZCO6ZyA6KaB6Kem5Y+R6L+Z5Liq5pa55rOVXHJcbiAgICAgKiBcclxuICAgICAqIEBwYXJhbSBkYXRhIOaOpeaUtuWIsOaVsOaNrlxyXG4gICAgICovXHJcbiAgICBwcm90ZWN0ZWQgX3JlY2VpdmVEYXRhKGRhdGE6IEJ1ZmZlcikge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGxldCBvZmZzZXQgPSAwO1xyXG4gICAgICAgICAgICBjb25zdCB0aXRsZV9sZW5ndGggPSBkYXRhLnJlYWRVSW50MzJCRSgwKTsgb2Zmc2V0ICs9IDQ7XHJcbiAgICAgICAgICAgIGNvbnN0IHRpdGxlID0gZGF0YS5zbGljZShvZmZzZXQsIG9mZnNldCArPSB0aXRsZV9sZW5ndGgpLnRvU3RyaW5nKCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJfZGF0YSA9IGRhdGEuc2xpY2Uob2Zmc2V0KTtcclxuXHJcbiAgICAgICAgICAgIHRoaXMuZW1pdCgnbWVzc2FnZScsIHRpdGxlLCByX2RhdGEpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHRoaXMuZW1pdCgnZXJyb3InLCBlcnJvcik7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIG9uKGV2ZW50OiAnZXJyb3InLCBsaXN0ZW5lcjogKGVycjogRXJyb3IpID0+IHZvaWQpOiB0aGlzXHJcbiAgICAvKipcclxuICAgICAqIOW9k+aUtuWIsOa2iOaBr1xyXG4gICAgICovXHJcbiAgICBvbihldmVudDogJ21lc3NhZ2UnLCBsaXN0ZW5lcjogKHRpdGxlOiBzdHJpbmcsIGRhdGE6IEJ1ZmZlcikgPT4gdm9pZCk6IHRoaXNcclxuICAgIC8qKlxyXG4gICAgICog5b2T6L+e5o6l5bu656uLXHJcbiAgICAgKi9cclxuICAgIG9uKGV2ZW50OiAnb3BlbicsIGxpc3RlbmVyOiAoKSA9PiB2b2lkKTogdGhpc1xyXG4gICAgLyoqXHJcbiAgICAgKiDmlq3lvIDov57mjqVcclxuICAgICAqL1xyXG4gICAgb24oZXZlbnQ6ICdjbG9zZScsIGxpc3RlbmVyOiAoY29kZTogbnVtYmVyLCByZWFzb246IHN0cmluZykgPT4gdm9pZCk6IHRoaXNcclxuICAgIG9uKGV2ZW50OiBzdHJpbmcsIGxpc3RlbmVyOiBGdW5jdGlvbik6IHRoaXMge1xyXG4gICAgICAgIHN1cGVyLm9uKGV2ZW50LCBsaXN0ZW5lcik7XHJcbiAgICAgICAgcmV0dXJuIHRoaXM7XHJcbiAgICB9XHJcblxyXG4gICAgb25jZShldmVudDogJ2Vycm9yJywgbGlzdGVuZXI6IChlcnI6IEVycm9yKSA9PiB2b2lkKTogdGhpc1xyXG4gICAgb25jZShldmVudDogJ21lc3NhZ2UnLCBsaXN0ZW5lcjogKHRpdGxlOiBzdHJpbmcsIGRhdGE6IEJ1ZmZlcikgPT4gdm9pZCk6IHRoaXNcclxuICAgIG9uY2UoZXZlbnQ6ICdvcGVuJywgbGlzdGVuZXI6ICgpID0+IHZvaWQpOiB0aGlzXHJcbiAgICBvbmNlKGV2ZW50OiAnY2xvc2UnLCBsaXN0ZW5lcjogKGNvZGU6IG51bWJlciwgcmVhc29uOiBzdHJpbmcpID0+IHZvaWQpOiB0aGlzXHJcbiAgICBvbmNlKGV2ZW50OiBzdHJpbmcsIGxpc3RlbmVyOiBGdW5jdGlvbik6IHRoaXMge1xyXG4gICAgICAgIHN1cGVyLm9uY2UoZXZlbnQsIGxpc3RlbmVyKTtcclxuICAgICAgICByZXR1cm4gdGhpcztcclxuICAgIH1cclxufSJdfQ==
