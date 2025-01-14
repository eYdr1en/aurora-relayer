/* This is free and unencumbered software released into the public domain. */
import sql from 'sql-bricks';
export function compileTopics(topics) {
    if (!topics || topics.length == 0)
        return null;
    const operands = topics
        .map((topic, i) => {
        if (topic === null)
            return [];
        if (typeof topic === 'string') {
            return [sql.eq(`e.topics[${i + 1}]`, hexToBytes(topic))];
        }
        if (Array.isArray(topic)) {
            const operands = topic
                .map((topic) => {
                if (topic === null)
                    return [];
                return [sql.eq(`e.topics[${i + 1}]`, hexToBytes(topic))];
            })
                .flat();
            return [sql.or(...operands)];
        }
        throw Error('unreachable');
    })
        .flat();
    return sql.and(...operands);
}
// Duplicated here because of https://github.com/kulshekhar/ts-jest/issues/970
function hexToBytes(input) {
    return Buffer.from(input.substring(2), 'hex');
}
