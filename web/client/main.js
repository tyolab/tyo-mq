mq.createConsumer(function (consumer) {
        console.log('Subscriber: ' + consumer.getId());
        var test = 0;

        consumer.on('connect', () => {
            console.log('consumer\'s own connect listenr');
        });

        consumer.subscribe('test', (data) => {
            test += 1;
            if (data === 'test-a') 
                console.log('test1 succeeded!');
            else   
                console.log('test1 failed');

            //if (test === 2) disconnectConsumer();
        });

        consumer.subscribe('test2', (data) => {
            test += 1;
            if (data === 'test-b') 
                console.log('test2 succeeded!');
            else   
                console.log('test2 failed');

            //if (test === 2) disconnectConsumer();
        });
    }
);

