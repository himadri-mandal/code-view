package demo.orders.messaging;

import demo.orders.domain.Order;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.stream.function.StreamBridge;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

@Component
public class OrderPublisher {
  private final KafkaTemplate<String, Order> kafka;
  private final StreamBridge bridge;

  @Value("${app.topics.orders}")
  private String topic;

  public OrderPublisher(KafkaTemplate<String, Order> kafka, StreamBridge bridge) {
    this.kafka = kafka;
    this.bridge = bridge;
  }

  public void publish(Order order) {
    try {
      kafka.send(topic, order.toString(), order);
    } catch (RuntimeException e) {
      bridge.send("audit-out-0", "failed " + order);
    }
  }
}
