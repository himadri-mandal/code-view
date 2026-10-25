package demo.orders.config;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

@Configuration
public class KafkaTopics {
  @Bean
  NewTopic orders() {
    return TopicBuilder.name("orders.v1").partitions(6).replicas(3).build();
  }

  @Bean
  NewTopic shipments() {
    return new NewTopic(Topics.SHIPMENTS, 3, (short) 1);
  }
}
